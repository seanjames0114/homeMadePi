// ── Clock ─────────────────────────────────────────────────────────────────
function updateClock() {
    const now = new Date();
    document.getElementById('clock').textContent = now.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    });
    document.getElementById('date').textContent = now.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
}
setInterval(updateClock, 1000);
updateClock();

// ── Toasts ────────────────────────────────────────────────────────────────
function toast(msg, type = 'info', ms = 3200) {
    const icons = { success: 'circle-check', error: 'circle-exclamation', info: 'circle-info' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fas fa-${icons[type]}"></i><span>${msg}</span>`;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => {
        el.style.animation = 'tout .3s ease forwards';
        setTimeout(() => el.remove(), 320);
    }, ms);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtBytes(b) {
    if (!b) return '0 B';
    const u = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return `${(b / 1024 ** i).toFixed(1)} ${u[i]}`;
}
function fmtMs(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function setGauge(id, pct) {
    const el = document.getElementById(id);
    if (el) el.style.strokeDashoffset = 125.6 * (1 - Math.min(pct, 100) / 100);
}

// ── System stats ──────────────────────────────────────────────────────────
let prevNet = null;

async function fetchSystem() {
    try {
        const d = await fetch('/api/system').then(r => r.json());

        setGauge('g-cpu', d.cpu.percent);
        document.getElementById('v-cpu').textContent = `${Math.round(d.cpu.percent)}%`;

        setGauge('g-ram', d.memory.percent);
        document.getElementById('v-ram').textContent = `${Math.round(d.memory.percent)}%`;
        document.getElementById('v-ram-detail').textContent =
            `${fmtBytes(d.memory.used)} / ${fmtBytes(d.memory.total)}`;

        setGauge('g-disk', d.disk.percent);
        document.getElementById('v-disk').textContent = `${Math.round(d.disk.percent)}%`;
        document.getElementById('v-disk-detail').textContent =
            `${fmtBytes(d.disk.used)} / ${fmtBytes(d.disk.total)}`;

        if (d.cpu.freq) {
            document.getElementById('v-freq').textContent =
                `${(d.cpu.freq / 1000).toFixed(2)} GHz`;
        }

        if (d.temperature != null) {
            const t = d.temperature;
            const color = t > 70 ? '#dc2626' : t > 55 ? '#d97706' : '#059669';
            const g = document.getElementById('g-temp');
            g.setAttribute('stroke', color);
            setGauge('g-temp', (t / 85) * 100);
            document.getElementById('v-temp').textContent = `${t.toFixed(1)}°C`;
        }

        if (prevNet) {
            const up = Math.max(0, d.network.bytes_sent - prevNet.bytes_sent);
            const dn = Math.max(0, d.network.bytes_recv - prevNet.bytes_recv);
            document.getElementById('net-up').textContent   = `${fmtBytes(up)}/s`;
            document.getElementById('net-down').textContent = `${fmtBytes(dn)}/s`;
        }
        document.getElementById('net-total').textContent =
            fmtBytes((d.network.bytes_sent || 0) + (d.network.bytes_recv || 0));
        prevNet = d.network;
    } catch (_) {}
}
fetchSystem();
setInterval(fetchSystem, 5000);

// ── Spotify ───────────────────────────────────────────────────────────────
const sp = { playing: false, shuffle: false, repeat: 'off', volume: 50, prog: 0, dur: 0, ticker: null };

function renderSpotify(d) {
    if (!d.authenticated) {
        document.getElementById('spotify-auth').style.display = 'flex';
        document.getElementById('spotify-player').style.display = 'none';
        return;
    }
    document.getElementById('spotify-auth').style.display = 'none';
    document.getElementById('spotify-player').style.display = 'flex';

    if (!d.track && !d.playing) return;

    document.getElementById('track-name').textContent   = d.track  || 'Not Playing';
    document.getElementById('track-artist').textContent = d.artist || '—';
    document.getElementById('track-album').textContent  = d.album  || '—';
    document.getElementById('spotify-device').textContent = d.device ? `▶ ${d.device}` : '';

    const img = document.getElementById('album-art');
    const ph  = document.getElementById('album-placeholder');
    if (d.album_art) {
        img.src = d.album_art;
        img.onload = () => { img.classList.add('visible'); ph.style.display = 'none'; };
    } else {
        img.classList.remove('visible');
        ph.style.display = 'flex';
    }

    sp.playing = d.playing;
    document.getElementById('play-icon').className = d.playing ? 'fas fa-pause' : 'fas fa-play';

    sp.prog = d.progress_ms || 0;
    sp.dur  = d.duration_ms || 0;
    renderProgress();

    sp.volume = d.volume ?? 50;
    document.getElementById('vol-slider').value = sp.volume;
    document.getElementById('vol-value').textContent = `${sp.volume}%`;

    sp.shuffle = d.shuffle;
    document.getElementById('btn-shuffle').classList.toggle('active', d.shuffle);

    sp.repeat = d.repeat;
    document.getElementById('btn-repeat').classList.toggle('active', d.repeat !== 'off');

    if (sp.ticker) clearInterval(sp.ticker);
    if (d.playing) sp.ticker = setInterval(() => { sp.prog += 1000; renderProgress(); }, 1000);
}

function renderProgress() {
    const pct = sp.dur > 0 ? Math.min((sp.prog / sp.dur) * 100, 100) : 0;
    document.getElementById('prog-fill').style.width    = `${pct}%`;
    document.getElementById('prog-current').textContent = fmtMs(sp.prog);
    document.getElementById('prog-total').textContent   = fmtMs(sp.dur);
}

async function fetchSpotify() {
    try { renderSpotify(await fetch('/api/spotify/current').then(r => r.json())); } catch (_) {}
}

async function spotifyAction(action) {
    let body = { action };
    if (action === 'playpause') {
        body.action = sp.playing ? 'pause' : 'play';
    } else if (action === 'shuffle') {
        body = { action: 'shuffle', value: !sp.shuffle };
    } else if (action === 'repeat') {
        const states = ['off', 'track', 'context'];
        body = { action: 'repeat', value: states[(states.indexOf(sp.repeat) + 1) % states.length] };
    }
    try {
        await fetch('/api/spotify/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        setTimeout(fetchSpotify, 400);
    } catch (_) { toast('Spotify control failed', 'error'); }
}

let volTimer;
function setVolume(v) {
    document.getElementById('vol-value').textContent = `${v}%`;
    clearTimeout(volTimer);
    volTimer = setTimeout(() => {
        fetch('/api/spotify/control', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'volume', value: parseInt(v) }),
        }).catch(() => {});
    }, 350);
}

fetchSpotify();
setInterval(fetchSpotify, 6000);

// ── Weather ───────────────────────────────────────────────────────────────
const WX = {
    0:[' ☀️','Clear'],1:['🌤','Mainly clear'],2:['⛅','Partly cloudy'],3:['☁️','Overcast'],
    45:['🌫','Fog'],48:['🌫','Icy fog'],
    51:['🌦','Light drizzle'],53:['🌦','Drizzle'],55:['🌧','Heavy drizzle'],
    61:['🌧','Light rain'],63:['🌧','Rain'],65:['🌧','Heavy rain'],
    71:['🌨','Light snow'],73:['❄️','Snow'],75:['❄️','Heavy snow'],
    80:['🌦','Showers'],81:['🌧','Showers'],82:['⛈','Heavy showers'],
    85:['🌨','Snow showers'],95:['⛈','Thunderstorm'],99:['⛈','Thunderstorm'],
};
const wx = c => WX[c] || ['🌡','Unknown'];

async function fetchWeather(lat, lon) {
    const el = document.getElementById('weather-content');
    try {
        const r = await fetch(`/api/weather?lat=${lat}&lon=${lon}`).then(r => r.json());
        if (!r.success) throw new Error(r.error);
        const c = r.data.current, d = r.data.daily;
        const [icon, desc] = wx(c.weather_code);
        el.innerHTML = `
            <div class="w-current">
                <div class="w-icon">${icon}</div>
                <div>
                    <div class="w-temp">${Math.round(c.temperature_2m)}°F</div>
                    <div class="w-desc">${desc}</div>
                    <div class="w-feels">Feels like ${Math.round(c.apparent_temperature)}°F</div>
                </div>
            </div>
            <div class="w-details">
                <div class="w-detail"><i class="fas fa-droplet"></i><span>${c.relative_humidity_2m}% humidity</span></div>
                <div class="w-detail"><i class="fas fa-wind"></i><span>${Math.round(c.wind_speed_10m)} mph</span></div>
            </div>
            <div class="w-forecast">
                ${d.time.slice(0,5).map((dt, i) => {
                    const [fi] = wx(d.weather_code[i]);
                    const name = i === 0 ? 'Today' : i === 1 ? 'Tmrw' :
                        new Date(dt).toLocaleDateString('en-US',{weekday:'short'});
                    return `<div class="f-day">
                        <div class="f-name">${name}</div>
                        <div class="f-icon">${fi}</div>
                        <div class="f-hi">${Math.round(d.temperature_2m_max[i])}°</div>
                        <div class="f-lo">${Math.round(d.temperature_2m_min[i])}°</div>
                    </div>`;
                }).join('')}
            </div>`;
    } catch (_) {
        el.innerHTML = `<div class="loading"><i class="fas fa-triangle-exclamation"></i>
            <span>Couldn't load weather. <button onclick="requestLocation()" style="background:none;border:none;color:var(--blue);cursor:pointer;font:inherit">Try again</button></span></div>`;
    }
}

function requestLocation() {
    if (!navigator.geolocation) { fetchWeather(40.7128, -74.006); return; }
    navigator.geolocation.getCurrentPosition(
        p => { localStorage.setItem('lat', p.coords.latitude); localStorage.setItem('lon', p.coords.longitude); fetchWeather(p.coords.latitude, p.coords.longitude); },
        ()  => fetchWeather(40.7128, -74.006)
    );
}

(function initWeather() {
    const lat = localStorage.getItem('lat'), lon = localStorage.getItem('lon');
    lat && lon ? fetchWeather(lat, lon) : requestLocation();
})();
setInterval(() => fetchWeather(localStorage.getItem('lat')||40.7128, localStorage.getItem('lon')||-74.006), 300000);

// ── Pi-hole ───────────────────────────────────────────────────────────────
async function fetchPihole() {
    const el = document.getElementById('pihole-content');
    try {
        const d = await fetch('/api/pihole/status').then(r => r.json());
        if (!d.available) {
            el.innerHTML = `<div class="ph-unavail"><i class="fas fa-shield-halved"></i>Pi-hole not detected<small>Set PIHOLE_HOST in .env</small></div>`;
            document.getElementById('pihole-toggle').disabled = true;
            return;
        }
        const on = d.status === 'enabled';
        const tog = document.getElementById('pihole-toggle');
        tog.checked = on; tog.disabled = false;
        el.innerHTML = `
            <div class="ph-stats">
                <div class="ph-big">
                    <div class="ph-big-num">${Number(d.ads_blocked).toLocaleString()}</div>
                    <div class="ph-big-lbl">Ads blocked today</div>
                </div>
                <div class="ph-row"><span>Status</span><span class="ph-badge ${d.status}"><i class="fas fa-${on?'shield-halved':'shield'}"></i> ${d.status}</span></div>
                <div class="ph-row"><span>Queries today</span><span>${Number(d.queries_today).toLocaleString()}</span></div>
                <div class="ph-row"><span>Block rate</span><span>${(+d.ads_percentage||0).toFixed(1)}%</span></div>
                <div class="ph-row"><span>Domains blocked</span><span>${Number(d.domains_blocked).toLocaleString()}</span></div>
            </div>`;
    } catch (_) {
        el.innerHTML = `<div class="ph-unavail"><i class="fas fa-triangle-exclamation"></i>Error loading Pi-hole</div>`;
    }
}

async function togglePihole(on) {
    try {
        const r = await fetch('/api/pihole/toggle', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ action: on ? 'enable' : 'disable' }),
        });
        if (r.ok) { toast(`Ad blocker ${on ? 'enabled' : 'disabled'}`, 'success'); setTimeout(fetchPihole, 1200); }
        else toast('Failed to toggle Pi-hole', 'error');
    } catch (_) { toast('Failed to toggle Pi-hole', 'error'); }
}

fetchPihole();
setInterval(fetchPihole, 30000);
