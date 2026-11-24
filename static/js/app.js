/* ── Utilities ───────────────────────────────────────────────────────────────── */
function toast(msg, type = 'info', ms = 3000) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
}

async function api(path, opts = {}) {
    const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
}

function fmt(n, unit = '') {
    if (n == null) return '—';
    return n.toLocaleString() + (unit ? ' ' + unit : '');
}

/* ── Clock ───────────────────────────────────────────────────────────────────── */
function tickClock() {
    const now = new Date();
    document.getElementById('clock').textContent = now.toLocaleTimeString();
    document.getElementById('date').textContent = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
setInterval(tickClock, 1000);
tickClock();

/* ── Sidebar navigation ──────────────────────────────────────────────────────── */
const PAGE_TITLES = { overview: 'Overview', media: 'Media', smarthome: 'Smart Home', network: 'Network', planner: 'Planner' };

function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    document.getElementById('page-' + id).classList.add('active');
    document.querySelector(`.nav-link[data-page="${id}"]`).classList.add('active');
    document.getElementById('page-title').textContent = PAGE_TITLES[id] || id;
    location.hash = id;
    if (id === 'media')     { fetchSpotify(); }
    if (id === 'smarthome') { if (HUE_CONFIGURED) fetchHue(); if (KASA_AVAILABLE) fetchPlugs(); }
    if (id === 'network')   { fetchDevices(); fetchUptime(); }
    if (id === 'planner')   { fetchCalendar(); fetchList('todo'); fetchList('grocery'); }
}

document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => showPage(link.dataset.page));
});

function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    const main = document.getElementById('main');
    const collapsed = sb.classList.toggle('collapsed');
    document.body.classList.toggle('sidebar-collapsed', collapsed);
}

// Deep-link on load
const initPage = location.hash.replace('#', '') || 'overview';
showPage(initPage);

/* ── System stats ────────────────────────────────────────────────────────────── */
function setGauge(id, pct, maxPct = 100) {
    const p = Math.min(pct, maxPct) / maxPct;
    const el = document.getElementById(id);
    if (el) el.style.strokeDashoffset = 125.6 * (1 - p);
}

async function fetchSystem() {
    try {
        const d = await api('/api/system');
        const cpu = d.cpu_pct ?? 0;
        const ram = d.ram_pct ?? 0;
        const disk = d.disk_pct ?? 0;
        const temp = d.cpu_temp;
        const tempPct = temp != null ? Math.min(temp / 85, 1) * 100 : 0;

        setGauge('g-cpu',  cpu);
        setGauge('g-ram',  ram);
        setGauge('g-disk', disk);
        setGauge('g-temp', tempPct);

        document.getElementById('v-cpu').textContent  = cpu.toFixed(0) + '%';
        document.getElementById('v-ram').textContent  = ram.toFixed(0) + '%';
        document.getElementById('v-disk').textContent = disk.toFixed(0) + '%';
        document.getElementById('v-temp').textContent = temp != null ? temp.toFixed(1) + '°' : '—';

        document.getElementById('v-ram-detail').textContent = d.ram_used != null ? `${(d.ram_used/1024).toFixed(1)} / ${(d.ram_total/1024).toFixed(1)} GB` : '—';
        document.getElementById('v-disk-detail').textContent = d.disk_used != null ? `${(d.disk_used).toFixed(0)} / ${(d.disk_total).toFixed(0)} GB` : '—';

        // Topbar quick stats
        document.getElementById('qs-cpu-val').textContent  = cpu.toFixed(0) + '%';
        document.getElementById('qs-temp-val').textContent = temp != null ? temp.toFixed(1) + '°C' : '—';

        // Network I/O on media page
        if (d.net_sent_mb != null) document.getElementById('net-up').textContent   = d.net_sent_mb.toFixed(1) + ' MB/s';
        if (d.net_recv_mb != null) document.getElementById('net-down').textContent = d.net_recv_mb.toFixed(1) + ' MB/s';
    } catch {}
}
fetchSystem();
setInterval(fetchSystem, 5000);

/* ── Weather ─────────────────────────────────────────────────────────────────── */
function requestLocation() {
    if (!navigator.geolocation) { toast('Geolocation not supported', 'error'); return; }
    navigator.geolocation.getCurrentPosition(
        pos => fetchWeather(pos.coords.latitude, pos.coords.longitude),
        () => fetchWeather(null, null)
    );
}

const WX_ICONS = { 0:'☀️', 1:'🌤', 2:'⛅', 3:'☁️', 45:'🌫', 48:'🌫', 51:'🌦', 53:'🌦', 55:'🌧', 61:'🌧', 63:'🌧', 65:'🌨', 71:'❄️', 73:'❄️', 75:'❄️', 80:'🌦', 81:'🌧', 82:'⛈', 95:'⛈', 96:'⛈', 99:'⛈' };
const WX_DESC = { 0:'Clear sky', 1:'Mainly clear', 2:'Partly cloudy', 3:'Overcast', 45:'Foggy', 48:'Icy fog', 51:'Light drizzle', 53:'Drizzle', 55:'Heavy drizzle', 61:'Light rain', 63:'Rain', 65:'Heavy rain', 71:'Light snow', 73:'Snow', 75:'Heavy snow', 80:'Showers', 81:'Rain showers', 82:'Heavy showers', 95:'Thunderstorm', 96:'Thunderstorm+hail', 99:'Heavy thunderstorm' };

async function fetchWeather(lat, lon) {
    const el = document.getElementById('weather-content');
    el.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i><span>Fetching…</span></div>';
    try {
        const params = lat != null ? { lat, lon } : {};
        const d = await api('/api/weather?' + new URLSearchParams(params));
        const icon = WX_ICONS[d.weathercode] || '🌡';
        const desc = WX_DESC[d.weathercode] || 'Unknown';
        const f = t => (t * 9/5 + 32).toFixed(0); // C→F display
        el.innerHTML = `
            <div class="weather-main">
                <div class="weather-icon">${icon}</div>
                <div>
                    <div class="weather-temp">${d.temperature != null ? d.temperature.toFixed(0) + '°C' : '—'}</div>
                    <div class="weather-desc">${desc}</div>
                </div>
            </div>
            <div class="weather-details">
                <div class="weather-row"><i class="fas fa-droplet"></i><span>Humidity ${d.humidity ?? '—'}%</span></div>
                <div class="weather-row"><i class="fas fa-wind"></i><span>Wind ${d.windspeed != null ? d.windspeed.toFixed(0) + ' km/h' : '—'}</span></div>
                <div class="weather-row"><i class="fas fa-eye"></i><span>Apparent ${d.apparent != null ? d.apparent.toFixed(0) + '°C' : '—'}</span></div>
                ${d.location ? `<div class="weather-row"><i class="fas fa-location-dot"></i><span>${d.location}</span></div>` : ''}
            </div>`;
    } catch (e) { el.innerHTML = `<div class="loading" style="color:var(--red)"><i class="fas fa-circle-exclamation"></i><span>${e.message}</span></div>`; }
}
fetchWeather(null, null);
setInterval(() => fetchWeather(null, null), 600000);

/* ── Pi-hole ─────────────────────────────────────────────────────────────────── */
async function fetchPihole() {
    try {
        const d = await api('/api/pihole/stats');
        document.getElementById('pihole-toggle').checked = d.status === 'enabled';
        const c = document.getElementById('pihole-content');
        c.innerHTML = `<div class="pihole-stats">
            <div class="phole-tile"><div class="num">${fmt(d.queries_today)}</div><div class="lbl">Queries today</div></div>
            <div class="phole-tile"><div class="num" style="color:var(--red)">${fmt(d.ads_blocked)}</div><div class="lbl">Ads blocked</div></div>
            <div class="phole-tile"><div class="num" style="color:var(--yellow)">${d.block_pct != null ? d.block_pct.toFixed(1) + '%' : '—'}</div><div class="lbl">Block rate</div></div>
            <div class="phole-tile"><div class="num">${fmt(d.domains_on_blocklist)}</div><div class="lbl">Blocklist size</div></div>
        </div>`;
    } catch (e) {
        document.getElementById('pihole-content').innerHTML = `<div class="setup-hint"><i class="fas fa-circle-info"></i><div><strong>Pi-hole not reachable</strong><p>Set <code>PIHOLE_HOST</code> and <code>PIHOLE_API_TOKEN</code> in .env</p></div></div>`;
    }
}
fetchPihole();
setInterval(fetchPihole, 30000);

async function togglePihole(enable) {
    try {
        const d = await api('/api/pihole/' + (enable ? 'enable' : 'disable'), { method: 'POST' });
        toast('Pi-hole ' + (enable ? 'enabled' : 'disabled'), 'success');
    } catch (e) { toast('Pi-hole error: ' + e.message, 'error'); fetchPihole(); }
}

/* ── Spotify ─────────────────────────────────────────────────────────────────── */
let spotifyPoller = null;

async function fetchSpotify() {
    if (!SPOTIFY_CLIENT_ID) return;
    try {
        const d = await api('/api/spotify/current');
        if (d.error === 'no_token') { showSpotifyAuth(); return; }
        if (d.error) { return; }

        document.getElementById('spotify-auth').style.display   = 'none';
        document.getElementById('spotify-player').style.display = 'flex';

        document.getElementById('track-name').textContent   = d.name || 'Not playing';
        document.getElementById('track-artist').textContent = d.artist || '—';
        document.getElementById('track-album').textContent  = d.album  || '—';
        document.getElementById('spotify-device').textContent = d.device || '';

        const art = document.getElementById('album-art');
        const ph  = document.getElementById('album-placeholder');
        if (d.image) { art.src = d.image; art.style.display = 'block'; ph.style.display = 'none'; }
        else         { art.style.display = 'none'; ph.style.display = 'flex'; }

        const pct = d.duration ? (d.progress / d.duration) * 100 : 0;
        document.getElementById('prog-fill').style.width = pct + '%';
        document.getElementById('prog-current').textContent = msToTime(d.progress || 0);
        document.getElementById('prog-total').textContent   = msToTime(d.duration || 0);

        const playIcon = document.getElementById('play-icon');
        playIcon.className = d.is_playing ? 'fas fa-pause' : 'fas fa-play';

        const vol = d.volume ?? 50;
        document.getElementById('vol-slider').value       = vol;
        document.getElementById('vol-value').textContent  = vol + '%';

        document.getElementById('btn-shuffle').classList.toggle('active', !!d.shuffle);
        document.getElementById('btn-repeat').classList.toggle('active', d.repeat && d.repeat !== 'off');

        if (!spotifyPoller) spotifyPoller = setInterval(fetchSpotify, 5000);
    } catch { showSpotifyAuth(); }
}

function showSpotifyAuth() {
    document.getElementById('spotify-auth').style.display   = 'flex';
    document.getElementById('spotify-player').style.display = 'none';
    if (spotifyPoller) { clearInterval(spotifyPoller); spotifyPoller = null; }
}

function msToTime(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function spotifyAction(action) {
    try { await api('/api/spotify/' + action, { method: 'POST' }); setTimeout(fetchSpotify, 300); }
    catch (e) { toast('Spotify: ' + e.message, 'error'); }
}

let volTimer = null;
function setVolume(val) {
    document.getElementById('vol-value').textContent = val + '%';
    clearTimeout(volTimer);
    volTimer = setTimeout(() => api('/api/spotify/volume?vol=' + val, { method: 'POST' }).catch(() => {}), 400);
}

/* ── Smart Home tabs ────────────────────────────────────────────────────────── */
function showShTab(id) {
    document.querySelectorAll('.sh-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
    document.querySelectorAll('.sh-panel').forEach(p => p.classList.toggle('active', p.id === 'sh-' + id));
    if (id === 'devices') { if (HUE_CONFIGURED) fetchHue(); if (KASA_AVAILABLE) fetchPlugs(); }
}

// Detect when HA iframe is blocked (X-Frame-Options / CSP)
function initHaIframe() {
    const iframe = document.getElementById('ha-iframe');
    const blocked = document.getElementById('ha-blocked');
    if (!iframe) return;
    // If the iframe errors (net block / SAMEORIGIN) onerror fires; also try load+contentDocument check
    iframe.addEventListener('load', () => {
        try {
            // Will throw cross-origin if blocked
            void iframe.contentDocument;
        } catch {
            blocked.style.display = 'flex';
        }
    });
    iframe.addEventListener('error', () => { blocked.style.display = 'flex'; });
}
initHaIframe();

/* ── Hue Lights ─────────────────────────────────────────────────────────────── */
async function fetchHue() {
    if (!HUE_CONFIGURED) return;
    const el = document.getElementById('hue-content');
    el.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i><span>Loading…</span></div>';
    try {
        const lights = await api('/api/lights/hue');
        if (!lights.length) { el.innerHTML = '<div class="loading" style="color:var(--muted)">No lights found</div>'; return; }
        el.innerHTML = lights.map(l => `
            <div class="light-item">
                <div class="light-bulb ${l.on ? 'on' : 'off'}" id="bulb-${l.id}"><i class="fas fa-lightbulb"></i></div>
                <span class="light-name">${l.name}</span>
                <div class="light-controls">
                    <input type="range" class="brightness-slider" min="0" max="254" value="${l.brightness || 128}"
                        oninput="setHueBrightness('${l.id}', this.value)"
                        ${l.on ? '' : 'disabled'}>
                    <label class="toggle" title="${l.on ? 'Turn off' : 'Turn on'}">
                        <input type="checkbox" ${l.on ? 'checked' : ''} onchange="toggleHue('${l.id}', this.checked)">
                        <span class="toggle-track"><span class="toggle-thumb"></span></span>
                    </label>
                </div>
            </div>`).join('');
    } catch (e) { el.innerHTML = `<div class="loading" style="color:var(--red)"><i class="fas fa-circle-exclamation"></i><span>${e.message}</span></div>`; }
}

let hueTimers = {};
function setHueBrightness(id, val) {
    clearTimeout(hueTimers[id]);
    hueTimers[id] = setTimeout(() => {
        api(`/api/lights/hue/${id}`, { method: 'PUT', body: JSON.stringify({ bri: parseInt(val) }) }).catch(() => {});
    }, 300);
}

async function toggleHue(id, on) {
    try {
        await api(`/api/lights/hue/${id}`, { method: 'PUT', body: JSON.stringify({ on }) });
        const bulb = document.getElementById('bulb-' + id);
        if (bulb) { bulb.className = `light-bulb ${on ? 'on' : 'off'}`; }
    } catch (e) { toast('Hue error: ' + e.message, 'error'); fetchHue(); }
}

async function registerHue() {
    const btn = event.currentTarget;
    btn.disabled = true; btn.textContent = 'Press bridge button first, then click…';
    try {
        const d = await api('/api/lights/hue/register', { method: 'POST' });
        document.getElementById('hue-reg-result').innerHTML = d.username
            ? `<strong>Success!</strong> Add to .env:<br><code>HUE_USERNAME=${d.username}</code>`
            : d.error;
    } catch (e) { document.getElementById('hue-reg-result').textContent = e.message; }
    finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-link"></i> Register Bridge'; }
}

/* ── Kasa Plugs ─────────────────────────────────────────────────────────────── */
async function fetchPlugs() {
    if (!KASA_AVAILABLE) return;
    const el = document.getElementById('plugs-content');
    el.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i><span>Scanning…</span></div>';
    try {
        const plugs = await api('/api/plugs');
        if (!plugs.length) { el.innerHTML = '<div class="loading" style="color:var(--muted)">No Kasa plugs found on network</div>'; return; }
        el.innerHTML = plugs.map(p => `
            <div class="plug-item">
                <div class="plug-icon ${p.on ? 'on' : 'off'}" id="picon-${p.ip.replace(/\./g,'-')}"><i class="fas fa-plug"></i></div>
                <div>
                    <div class="plug-name">${p.name || p.alias || p.ip}</div>
                    <div class="plug-info">${p.ip}${p.power != null ? ' · ' + p.power.toFixed(1) + 'W' : ''}</div>
                </div>
                <label class="toggle">
                    <input type="checkbox" ${p.on ? 'checked' : ''} onchange="togglePlug('${p.ip}', this.checked)">
                    <span class="toggle-track"><span class="toggle-thumb"></span></span>
                </label>
            </div>`).join('');
    } catch (e) { el.innerHTML = `<div class="loading" style="color:var(--red)"><i class="fas fa-circle-exclamation"></i><span>${e.message}</span></div>`; }
}

async function togglePlug(ip, on) {
    try {
        await api(`/api/plugs/${ip}/toggle`, { method: 'POST', body: JSON.stringify({ on }) });
        const id = 'picon-' + ip.replace(/\./g, '-');
        const icon = document.getElementById(id);
        if (icon) icon.className = `plug-icon ${on ? 'on' : 'off'}`;
    } catch (e) { toast('Kasa error: ' + e.message, 'error'); fetchPlugs(); }
}

/* ── Network devices ─────────────────────────────────────────────────────────── */
async function fetchDevices() {
    const el = document.getElementById('devices-content');
    el.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i><span>Scanning ARP table…</span></div>';
    try {
        const devices = await api('/api/network/devices');
        if (!devices.length) { el.innerHTML = '<div class="loading" style="color:var(--muted)">No devices found</div>'; return; }
        el.innerHTML = `<table class="devices-table">
            <thead><tr><th>#</th><th>IP Address</th><th>MAC Address</th><th>Interface</th></tr></thead>
            <tbody>${devices.map((d, i) => `
                <tr>
                    <td style="color:var(--subtle)">${i + 1}</td>
                    <td><span class="ip-mono">${d.ip}</span></td>
                    <td><span class="mac-mono">${d.mac}</span></td>
                    <td><span class="device-vendor">${d.iface || '—'}</span></td>
                </tr>`).join('')}
            </tbody></table>`;
    } catch (e) { el.innerHTML = `<div class="loading" style="color:var(--red)"><i class="fas fa-circle-exclamation"></i><span>${e.message}</span></div>`; }
}

/* ── Uptime monitor ──────────────────────────────────────────────────────────── */
let uptimeHosts = [];

async function fetchUptime() {
    const el = document.getElementById('uptime-content');
    try {
        const d = await api('/api/network/uptime');
        uptimeHosts = d;
        renderUptime(d);
    } catch (e) { el.innerHTML = `<div class="loading" style="color:var(--red)"><i class="fas fa-circle-exclamation"></i><span>${e.message}</span></div>`; }
}

function renderUptime(hosts) {
    const el = document.getElementById('uptime-content');
    if (!hosts.length) { el.innerHTML = '<div class="loading" style="color:var(--muted)">No hosts added yet</div>'; return; }
    el.innerHTML = `<div class="uptime-list">${hosts.map(h => `
        <div class="uptime-row">
            <div class="uptime-dot ${h.status || 'pending'}"></div>
            <div style="flex:1">
                <div class="uptime-name">${h.name}</div>
                <div class="uptime-host">${h.host}</div>
            </div>
            <span class="uptime-status ${h.status || 'pending'}">${h.status === 'up' ? 'Online' : h.status === 'down' ? 'Offline' : 'Checking…'}</span>
            <button class="uptime-rm" onclick="removeUptimeHost('${h.host}')" title="Remove"><i class="fas fa-xmark"></i></button>
        </div>`).join('')}
    </div>`;
}

async function addUptimeHost(e) {
    e.preventDefault();
    const name = document.getElementById('uptime-name').value.trim();
    const host = document.getElementById('uptime-host').value.trim();
    if (!name || !host) return;
    try {
        await api('/api/network/uptime/hosts', { method: 'POST', body: JSON.stringify({ name, host }) });
        document.getElementById('uptime-name').value = '';
        document.getElementById('uptime-host').value = '';
        fetchUptime();
    } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function removeUptimeHost(host) {
    try {
        await api('/api/network/uptime/hosts', { method: 'DELETE', body: JSON.stringify({ host }) });
        fetchUptime();
    } catch (e) { toast('Error: ' + e.message, 'error'); }
}

setInterval(() => { if (document.getElementById('page-network').classList.contains('active')) fetchUptime(); }, 30000);

/* ── Calendar ────────────────────────────────────────────────────────────────── */
async function fetchCalendar() {
    const el = document.getElementById('calendar-content');
    el.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i></div>';
    try {
        const events = await api('/api/calendar');
        if (!events.length) {
            el.innerHTML = `<div class="cal-no-url">
                <p>No upcoming events, or calendar not configured.</p>
                <p>Add your calendar's iCal URL to .env as <code>ICAL_URL=…</code></p>
                <p>Google Calendar: Settings → your calendar → "Secret address in iCal format"</p>
            </div>`;
            return;
        }
        el.innerHTML = events.map(ev => `
            <div class="cal-event">
                <div class="cal-event-title">${ev.summary || 'Untitled event'}</div>
                <div class="cal-event-when">${ev.when}</div>
            </div>`).join('');
    } catch (e) { el.innerHTML = `<div class="loading" style="color:var(--red)"><i class="fas fa-circle-exclamation"></i><span>${e.message}</span></div>`; }
}

/* ── Lists (todo / grocery) ──────────────────────────────────────────────────── */
async function fetchList(name) {
    const el = document.getElementById(name === 'todo' ? 'todo-list' : 'grocery-list');
    try {
        const items = await api('/api/list/' + name);
        renderList(name, items);
    } catch {}
}

function renderList(name, items) {
    const el = document.getElementById(name === 'todo' ? 'todo-list' : 'grocery-list');
    if (!items.length) { el.innerHTML = '<div style="font-size:.82rem;color:var(--subtle);padding:.4rem 0">Nothing here yet</div>'; return; }
    el.innerHTML = items.map(it => `
        <div class="list-item" id="item-${name}-${it.id}">
            <input type="checkbox" ${it.done ? 'checked' : ''} onchange="toggleListItem('${name}', '${it.id}', this.checked)">
            <span class="item-text ${it.done ? 'done' : ''}">${escHtml(it.text)}</span>
            <button class="item-rm" onclick="deleteListItem('${name}', '${it.id}')"><i class="fas fa-xmark"></i></button>
        </div>`).join('');
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function addListItem(name, e) {
    e.preventDefault();
    const inp = document.getElementById(name + '-input');
    const text = inp.value.trim();
    if (!text) return;
    try {
        await api('/api/list/' + name, { method: 'POST', body: JSON.stringify({ text }) });
        inp.value = '';
        fetchList(name);
    } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function toggleListItem(name, id, done) {
    try {
        await api(`/api/list/${name}/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) });
        const span = document.querySelector(`#item-${name}-${id} .item-text`);
        if (span) span.classList.toggle('done', done);
    } catch (e) { toast('Error: ' + e.message, 'error'); fetchList(name); }
}

async function deleteListItem(name, id) {
    try {
        await api(`/api/list/${name}/${id}`, { method: 'DELETE' });
        document.getElementById(`item-${name}-${id}`)?.remove();
    } catch (e) { toast('Error: ' + e.message, 'error'); }
}
