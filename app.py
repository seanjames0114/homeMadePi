import asyncio
import base64
import json
import os
import re
import secrets
import subprocess
import time
import urllib.parse
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

import psutil
import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, session

load_dotenv()

try:
    from kasa import Discover
    KASA_AVAILABLE = True
except ImportError:
    KASA_AVAILABLE = False

try:
    from icalendar import Calendar as ICalendar
    ICAL_AVAILABLE = True
except ImportError:
    ICAL_AVAILABLE = False

# ── Config ────────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)

SPOTIFY_CLIENT_ID     = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
SPOTIFY_REDIRECT_URI  = os.environ.get("SPOTIFY_REDIRECT_URI", "http://localhost:5000/api/spotify/callback")
PIHOLE_API_TOKEN      = os.environ.get("PIHOLE_API_TOKEN", "")
PIHOLE_HOST           = os.environ.get("PIHOLE_HOST", "http://pi.hole")
HUE_BRIDGE_IP         = os.environ.get("HUE_BRIDGE_IP", "")
HUE_USERNAME          = os.environ.get("HUE_USERNAME", "")
HOME_ASSISTANT_URL    = os.environ.get("HOME_ASSISTANT_URL", "http://homeassistant.local:8123")
HA_TOKEN              = os.environ.get("HA_TOKEN", "")
ICAL_URL              = os.environ.get("ICAL_URL", "")
KASA_HOSTS            = [h.strip() for h in os.environ.get("KASA_HOSTS", "").split(",") if h.strip()]

DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

# ── Data helpers ──────────────────────────────────────────────────────────────
def load_json(name: str) -> list:
    path = DATA_DIR / f"{name}.json"
    try:
        return json.loads(path.read_text()) if path.exists() else []
    except Exception:
        return []

def save_json(name: str, data):
    tmp = DATA_DIR / f"{name}.tmp"
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(DATA_DIR / f"{name}.json")

# ── Main ──────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html",
        spotify_client_id=SPOTIFY_CLIENT_ID,
        spotify_redirect_uri=SPOTIFY_REDIRECT_URI,
        home_assistant_url=HOME_ASSISTANT_URL,
        ha_token_set=bool(HA_TOKEN),
        hue_configured=bool(HUE_BRIDGE_IP and HUE_USERNAME),
        hue_bridge_ip=HUE_BRIDGE_IP,
        kasa_available=KASA_AVAILABLE,
    )

# ── System ────────────────────────────────────────────────────────────────────
@app.route("/api/system")
def system_stats():
    cpu = psutil.cpu_percent(interval=0.5)
    freq = psutil.cpu_freq()
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    net = psutil.net_io_counters()
    temp = None
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            temp = int(f.read().strip()) / 1000.0
    except OSError:
        try:
            r = subprocess.run(["vcgencmd", "measure_temp"], capture_output=True, text=True, timeout=2)
            if r.returncode == 0:
                temp = float(r.stdout.replace("temp=", "").replace("'C\n", ""))
        except Exception:
            pass
    return jsonify({
        "cpu":    {"percent": cpu, "freq": freq.current if freq else None},
        "memory": {"percent": mem.percent, "used": mem.used, "total": mem.total},
        "disk":   {"percent": disk.percent, "used": disk.used, "total": disk.total},
        "temperature": temp,
        "network": {"bytes_sent": net.bytes_sent, "bytes_recv": net.bytes_recv},
    })

# ── Spotify ───────────────────────────────────────────────────────────────────
@app.route("/api/spotify/auth")
def spotify_auth():
    scope = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private"
    params = {"client_id": SPOTIFY_CLIENT_ID, "response_type": "code",
              "redirect_uri": SPOTIFY_REDIRECT_URI, "scope": scope, "state": secrets.token_hex(16)}
    return redirect("https://accounts.spotify.com/authorize?" + urllib.parse.urlencode(params))

@app.route("/api/spotify/callback")
def spotify_callback():
    code = request.args.get("code")
    if not code:
        return redirect("/?error=spotify_auth_failed")
    auth = base64.b64encode(f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()).decode()
    resp = requests.post("https://accounts.spotify.com/api/token",
        headers={"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "authorization_code", "code": code, "redirect_uri": SPOTIFY_REDIRECT_URI},
        timeout=10)
    if resp.status_code == 200:
        td = resp.json()
        session["spotify_access_token"] = td["access_token"]
        session["spotify_refresh_token"] = td.get("refresh_token")
        session["spotify_token_expires"] = time.time() + td["expires_in"]
    return redirect("/")

def _spotify_token():
    if "spotify_access_token" not in session:
        return None
    if time.time() > session.get("spotify_token_expires", 0) - 60:
        refresh = session.get("spotify_refresh_token")
        if not refresh:
            return None
        auth = base64.b64encode(f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()).decode()
        resp = requests.post("https://accounts.spotify.com/api/token",
            headers={"Authorization": f"Basic {auth}", "Content-Type": "application/x-www-form-urlencoded"},
            data={"grant_type": "refresh_token", "refresh_token": refresh}, timeout=10)
        if resp.status_code != 200:
            return None
        td = resp.json()
        session["spotify_access_token"] = td["access_token"]
        session["spotify_token_expires"] = time.time() + td["expires_in"]
    return session["spotify_access_token"]

@app.route("/api/spotify/current")
def spotify_current():
    token = _spotify_token()
    if not token:
        return jsonify({"authenticated": False})
    resp = requests.get("https://api.spotify.com/v1/me/player",
        headers={"Authorization": f"Bearer {token}"}, timeout=5)
    if resp.status_code == 204:
        return jsonify({"authenticated": True, "playing": False})
    if resp.status_code == 200:
        d = resp.json()
        item = d.get("item") or {}
        imgs = item.get("album", {}).get("images", [])
        return jsonify({
            "authenticated": True, "playing": d.get("is_playing", False),
            "track": item.get("name", ""), "artist": ", ".join(a["name"] for a in item.get("artists", [])),
            "album": item.get("album", {}).get("name", ""), "album_art": imgs[0]["url"] if imgs else "",
            "duration_ms": item.get("duration_ms", 0), "progress_ms": d.get("progress_ms", 0),
            "volume": (d.get("device") or {}).get("volume_percent", 50),
            "shuffle": d.get("shuffle_state", False), "repeat": d.get("repeat_state", "off"),
            "device": (d.get("device") or {}).get("name", ""),
        })
    return jsonify({"authenticated": True, "error": True})

@app.route("/api/spotify/control", methods=["POST"])
def spotify_control():
    token = _spotify_token()
    if not token:
        return jsonify({"error": "Not authenticated"}), 401
    p = request.get_json() or {}
    action = p.get("action")
    h = {"Authorization": f"Bearer {token}"}
    if action == "play":
        requests.put("https://api.spotify.com/v1/me/player/play", headers=h, timeout=5)
    elif action == "pause":
        requests.put("https://api.spotify.com/v1/me/player/pause", headers=h, timeout=5)
    elif action == "next":
        requests.post("https://api.spotify.com/v1/me/player/next", headers=h, timeout=5)
    elif action == "previous":
        requests.post("https://api.spotify.com/v1/me/player/previous", headers=h, timeout=5)
    elif action == "volume":
        vol = max(0, min(100, int(p.get("value", 50))))
        requests.put(f"https://api.spotify.com/v1/me/player/volume?volume_percent={vol}", headers=h, timeout=5)
    elif action == "shuffle":
        requests.put(f"https://api.spotify.com/v1/me/player/shuffle?state={str(p.get('value', False)).lower()}", headers=h, timeout=5)
    elif action == "repeat":
        state = p.get("value", "off")
        if state not in ("off", "track", "context"):
            return jsonify({"error": "Invalid state"}), 400
        requests.put(f"https://api.spotify.com/v1/me/player/repeat?state={state}", headers=h, timeout=5)
    else:
        return jsonify({"error": "Unknown action"}), 400
    return jsonify({"success": True})

# ── Pi-hole ───────────────────────────────────────────────────────────────────
@app.route("/api/pihole/status")
def pihole_status():
    try:
        resp = requests.get(f"{PIHOLE_HOST}/admin/api.php?summary&auth={PIHOLE_API_TOKEN}", timeout=3)
        if resp.status_code == 200:
            d = resp.json()
            return jsonify({"available": True, "status": d.get("status", "unknown"),
                "ads_blocked": d.get("ads_blocked_today", 0), "ads_percentage": d.get("ads_percentage_today", 0),
                "queries_today": d.get("dns_queries_today", 0), "domains_blocked": d.get("domains_being_blocked", 0)})
    except Exception:
        pass
    return jsonify({"available": False})

@app.route("/api/pihole/toggle", methods=["POST"])
def pihole_toggle():
    p = request.get_json() or {}
    action = p.get("action")
    if action not in ("enable", "disable"):
        return jsonify({"error": "Invalid action"}), 400
    try:
        resp = requests.get(f"{PIHOLE_HOST}/admin/api.php?{action}&auth={PIHOLE_API_TOKEN}", timeout=5)
        if resp.status_code == 200:
            return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Failed"}), 500

# ── Weather ───────────────────────────────────────────────────────────────────
@app.route("/api/weather")
def weather():
    lat = request.args.get("lat", "40.7128")
    lon = request.args.get("lon", "-74.0060")
    try:
        resp = requests.get("https://api.open-meteo.com/v1/forecast", params={
            "latitude": lat, "longitude": lon,
            "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,apparent_temperature",
            "daily": "temperature_2m_max,temperature_2m_min,weather_code",
            "temperature_unit": "fahrenheit", "wind_speed_unit": "mph", "timezone": "auto", "forecast_days": 5,
        }, timeout=10)
        if resp.status_code == 200:
            return jsonify({"success": True, "data": resp.json()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Failed"}), 500

# ── Network: device map ───────────────────────────────────────────────────────
@app.route("/api/network/devices")
def network_devices():
    devices = []
    try:
        result = subprocess.run(["ip", "neigh", "show"], capture_output=True, text=True, timeout=5)
        for line in result.stdout.strip().splitlines():
            parts = line.split()
            if len(parts) >= 5 and parts[3] == "lladdr":
                ip, mac, state = parts[0], parts[4], parts[-1]
                online = state in ("REACHABLE", "DELAY", "PROBE")
                hostname = ""
                try:
                    h = subprocess.run(["getent", "hosts", ip], capture_output=True, text=True, timeout=1)
                    if h.returncode == 0:
                        cols = h.stdout.split()
                        hostname = cols[1] if len(cols) > 1 else ""
                except Exception:
                    pass
                devices.append({"ip": ip, "mac": mac, "hostname": hostname, "online": online, "state": state})
    except Exception:
        pass
    try:
        devices.sort(key=lambda d: [int(x) for x in d["ip"].split(".")])
    except Exception:
        pass
    return jsonify({"devices": devices})

# ── Network: uptime monitors ──────────────────────────────────────────────────
@app.route("/api/network/uptime")
def network_uptime():
    results = []
    for h in load_json("uptime_hosts"):
        host = h.get("host", "")
        if not host:
            continue
        try:
            r = subprocess.run(["ping", "-c", "1", "-W", "1", host], capture_output=True, text=True, timeout=3)
            online = r.returncode == 0
            rtt = None
            if online:
                m = re.search(r"time=([\d.]+)", r.stdout)
                rtt = float(m.group(1)) if m else None
            results.append({"id": h.get("id"), "name": h.get("name", host), "host": host, "online": online, "rtt": rtt})
        except Exception:
            results.append({"id": h.get("id"), "name": h.get("name", host), "host": host, "online": False, "rtt": None})
    return jsonify({"hosts": results})

@app.route("/api/network/uptime/hosts", methods=["GET", "POST"])
def uptime_hosts():
    if request.method == "POST":
        p = request.get_json() or {}
        name, host = p.get("name", "").strip(), p.get("host", "").strip()
        if not name or not host:
            return jsonify({"error": "name and host required"}), 400
        hosts = load_json("uptime_hosts")
        hosts.append({"id": str(uuid.uuid4())[:8], "name": name, "host": host})
        save_json("uptime_hosts", hosts)
        return jsonify({"success": True})
    return jsonify({"hosts": load_json("uptime_hosts")})

@app.route("/api/network/uptime/hosts/<host_id>", methods=["DELETE"])
def delete_uptime_host(host_id):
    save_json("uptime_hosts", [h for h in load_json("uptime_hosts") if h.get("id") != host_id])
    return jsonify({"success": True})

# ── Home Assistant unified API ────────────────────────────────────────────────
_HA_SHOW_DOMAINS = {"light", "switch", "climate", "sensor", "binary_sensor",
                    "fan", "cover", "scene", "automation", "input_boolean",
                    "media_player", "lock"}
_HA_HIDE_IDS = {"sun.sun"}
_HA_HIDE_PREFIXES = ("zone.", "persistent_notification.", "update.", "number.",
                     "select.", "text.", "button.", "device_tracker.")

def _ha_headers():
    return {"Authorization": f"Bearer {HA_TOKEN}", "Content-Type": "application/json"}

@app.route("/api/ha/states")
def ha_states():
    if not HA_TOKEN:
        return jsonify({"error": "no_token"})
    try:
        r = requests.get(f"{HOME_ASSISTANT_URL}/api/states",
                         headers=_ha_headers(), timeout=6)
        all_states = r.json()
        filtered = []
        for s in all_states:
            eid = s.get("entity_id", "")
            domain = eid.split(".")[0]
            if domain not in _HA_SHOW_DOMAINS:
                continue
            if eid in _HA_HIDE_IDS:
                continue
            if any(eid.startswith(p) for p in _HA_HIDE_PREFIXES):
                continue
            filtered.append({
                "entity_id":  eid,
                "state":      s.get("state"),
                "attributes": s.get("attributes", {}),
                "last_changed": s.get("last_changed"),
            })
        return jsonify(filtered)
    except Exception as e:
        return jsonify({"error": str(e)}), 503

@app.route("/api/ha/service", methods=["POST"])
def ha_service():
    if not HA_TOKEN:
        return jsonify({"error": "no_token"}), 401
    data = request.json or {}
    domain  = data.get("domain", "")
    service = data.get("service", "")
    payload = data.get("data", {})
    if not domain or not service:
        return jsonify({"error": "missing domain or service"}), 400
    try:
        r = requests.post(
            f"{HOME_ASSISTANT_URL}/api/services/{domain}/{service}",
            headers=_ha_headers(), json=payload, timeout=6,
        )
        return jsonify(r.json() if r.content else {"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 503

# ── Hue Lights ────────────────────────────────────────────────────────────────
@app.route("/api/lights/hue")
def hue_lights():
    if not (HUE_BRIDGE_IP and HUE_USERNAME):
        return jsonify({"available": False, "reason": "not_configured"})
    try:
        resp = requests.get(f"http://{HUE_BRIDGE_IP}/api/{HUE_USERNAME}/lights", timeout=3)
        if resp.status_code == 200:
            lights = resp.json()
            if isinstance(lights, list):
                return jsonify({"available": False, "reason": "auth_error"})
            result = sorted([
                {"id": lid, "name": l["name"], "on": l["state"]["on"],
                 "brightness": l["state"].get("bri", 254), "reachable": l["state"].get("reachable", True),
                 "colormode": l["state"].get("colormode"), "type": l.get("type", "")}
                for lid, l in lights.items()
            ], key=lambda x: x["name"])
            return jsonify({"available": True, "lights": result})
    except Exception:
        pass
    return jsonify({"available": False, "reason": "unreachable"})

@app.route("/api/lights/hue/<light_id>", methods=["PUT"])
def control_hue_light(light_id):
    if not (HUE_BRIDGE_IP and HUE_USERNAME):
        return jsonify({"error": "Not configured"}), 400
    p = request.get_json() or {}
    state = {}
    if "on" in p:
        state["on"] = bool(p["on"])
    if "brightness" in p:
        state["bri"] = max(1, min(254, int(p["brightness"])))
    try:
        requests.put(f"http://{HUE_BRIDGE_IP}/api/{HUE_USERNAME}/lights/{light_id}/state",
            json=state, timeout=3)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/lights/hue/register", methods=["POST"])
def hue_register():
    if not HUE_BRIDGE_IP:
        return jsonify({"error": "Set HUE_BRIDGE_IP in .env first"}), 400
    try:
        resp = requests.post(f"http://{HUE_BRIDGE_IP}/api",
            json={"devicetype": "homemadepi#dashboard"}, timeout=5)
        data = resp.json()
        if isinstance(data, list):
            if data[0].get("success"):
                username = data[0]["success"]["username"]
                return jsonify({"success": True, "username": username})
            if data[0].get("error"):
                return jsonify({"error": data[0]["error"]["description"]}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Unknown error"}), 500

# ── Kasa Smart Plugs ──────────────────────────────────────────────────────────
if KASA_AVAILABLE:
    async def _kasa_devices():
        from kasa import Discover
        devs = []
        try:
            found = await Discover.discover(timeout=3)
            for ip, dev in found.items():
                try:
                    await dev.update()
                    devs.append({"ip": ip, "name": dev.alias, "is_on": dev.is_on, "model": dev.model})
                except Exception:
                    pass
            found_ips = {d["ip"] for d in devs}
            for ip in KASA_HOSTS:
                if ip not in found_ips:
                    try:
                        from kasa import SmartPlug
                        dev = SmartPlug(ip)
                        await dev.update()
                        devs.append({"ip": ip, "name": dev.alias, "is_on": dev.is_on, "model": dev.model})
                    except Exception:
                        pass
        except Exception:
            pass
        return devs

    async def _kasa_toggle(ip: str, turn_on: bool):
        from kasa import SmartPlug
        dev = SmartPlug(ip)
        await dev.update()
        if turn_on:
            await dev.turn_on()
        else:
            await dev.turn_off()

@app.route("/api/plugs")
def get_plugs():
    if not KASA_AVAILABLE:
        return jsonify({"available": False, "error": "Run: pip install python-kasa"})
    try:
        devices = asyncio.run(_kasa_devices())
        return jsonify({"available": True, "devices": devices})
    except Exception as e:
        return jsonify({"available": False, "error": str(e)})

@app.route("/api/plugs/<path:ip>/toggle", methods=["POST"])
def toggle_plug(ip):
    if not KASA_AVAILABLE:
        return jsonify({"error": "python-kasa not installed"}), 500
    p = request.get_json() or {}
    try:
        asyncio.run(_kasa_toggle(ip, bool(p.get("on", True))))
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Calendar ──────────────────────────────────────────────────────────────────
@app.route("/api/calendar")
def calendar_events():
    if not ICAL_URL:
        return jsonify({"available": False, "reason": "no_url"})
    if not ICAL_AVAILABLE:
        return jsonify({"available": False, "reason": "install_required"})
    try:
        resp = requests.get(ICAL_URL, timeout=10)
        cal = ICalendar.from_ical(resp.content)
        now = datetime.now()
        limit = now + timedelta(days=14)
        events = []
        for comp in cal.walk():
            if comp.name != "VEVENT":
                continue
            dtstart = comp.get("DTSTART")
            if not dtstart:
                continue
            dt = dtstart.dt
            if isinstance(dt, date) and not isinstance(dt, datetime):
                dt = datetime(dt.year, dt.month, dt.day)
            if getattr(dt, "tzinfo", None):
                dt = dt.replace(tzinfo=None)
            if now <= dt <= limit:
                events.append({
                    "summary": str(comp.get("SUMMARY", "Untitled")),
                    "start": dt.isoformat(),
                    "location": str(comp.get("LOCATION", "")),
                })
        events.sort(key=lambda e: e["start"])
        return jsonify({"available": True, "events": events[:30]})
    except Exception as e:
        return jsonify({"available": False, "error": str(e)})

# ── Lists ─────────────────────────────────────────────────────────────────────
@app.route("/api/list/<listname>", methods=["GET", "POST"])
def list_items(listname):
    if listname not in ("todo", "grocery"):
        return jsonify({"error": "Unknown list"}), 400
    if request.method == "POST":
        p = request.get_json() or {}
        text = p.get("text", "").strip()
        if not text:
            return jsonify({"error": "text required"}), 400
        items = load_json(listname)
        items.append({"id": str(uuid.uuid4())[:8], "text": text, "done": False,
                      "created": datetime.now().isoformat()})
        save_json(listname, items)
        return jsonify({"success": True})
    return jsonify({"items": load_json(listname)})

@app.route("/api/list/<listname>/<item_id>", methods=["PATCH", "DELETE"])
def modify_list_item(listname, item_id):
    if listname not in ("todo", "grocery"):
        return jsonify({"error": "Unknown list"}), 400
    items = load_json(listname)
    if request.method == "DELETE":
        items = [i for i in items if i["id"] != item_id]
    else:
        p = request.get_json() or {}
        for item in items:
            if item["id"] == item_id:
                if "done" in p:
                    item["done"] = bool(p["done"])
                if "text" in p:
                    item["text"] = p["text"].strip()
    save_json(listname, items)
    return jsonify({"success": True})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
