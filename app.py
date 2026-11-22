import base64
import os
import secrets
import subprocess
import time
import urllib.parse

import psutil
import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, session

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)

SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
SPOTIFY_REDIRECT_URI = os.environ.get(
    "SPOTIFY_REDIRECT_URI", "http://localhost:5000/api/spotify/callback"
)
PIHOLE_API_TOKEN = os.environ.get("PIHOLE_API_TOKEN", "")
PIHOLE_HOST = os.environ.get("PIHOLE_HOST", "http://pi.hole")


@app.route("/")
def index():
    return render_template(
        "index.html",
        spotify_client_id=SPOTIFY_CLIENT_ID,
        spotify_redirect_uri=SPOTIFY_REDIRECT_URI,
    )


# ── System ────────────────────────────────────────────────────────────────────

@app.route("/api/system")
def system_stats():
    cpu_percent = psutil.cpu_percent(interval=0.5)
    cpu_freq = psutil.cpu_freq()
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    net = psutil.net_io_counters()

    temp = None
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            temp = int(f.read().strip()) / 1000.0
    except OSError:
        try:
            result = subprocess.run(
                ["vcgencmd", "measure_temp"], capture_output=True, text=True, timeout=2
            )
            if result.returncode == 0:
                temp = float(result.stdout.replace("temp=", "").replace("'C\n", ""))
        except Exception:
            pass

    return jsonify(
        {
            "cpu": {
                "percent": cpu_percent,
                "freq": cpu_freq.current if cpu_freq else None,
            },
            "memory": {
                "percent": mem.percent,
                "used": mem.used,
                "total": mem.total,
            },
            "disk": {
                "percent": disk.percent,
                "used": disk.used,
                "total": disk.total,
            },
            "temperature": temp,
            "network": {
                "bytes_sent": net.bytes_sent,
                "bytes_recv": net.bytes_recv,
            },
        }
    )


# ── Spotify ───────────────────────────────────────────────────────────────────

@app.route("/api/spotify/auth")
def spotify_auth():
    scope = (
        "user-read-playback-state user-modify-playback-state "
        "user-read-currently-playing playlist-read-private"
    )
    params = {
        "client_id": SPOTIFY_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": SPOTIFY_REDIRECT_URI,
        "scope": scope,
        "state": secrets.token_hex(16),
    }
    return redirect(
        "https://accounts.spotify.com/authorize?" + urllib.parse.urlencode(params)
    )


@app.route("/api/spotify/callback")
def spotify_callback():
    code = request.args.get("code")
    if not code:
        return redirect("/?error=spotify_auth_failed")

    auth_header = base64.b64encode(
        f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()
    ).decode()

    resp = requests.post(
        "https://accounts.spotify.com/api/token",
        headers={
            "Authorization": f"Basic {auth_header}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": SPOTIFY_REDIRECT_URI,
        },
        timeout=10,
    )

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

        auth_header = base64.b64encode(
            f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()
        ).decode()
        resp = requests.post(
            "https://accounts.spotify.com/api/token",
            headers={
                "Authorization": f"Basic {auth_header}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"grant_type": "refresh_token", "refresh_token": refresh},
            timeout=10,
        )
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

    resp = requests.get(
        "https://api.spotify.com/v1/me/player",
        headers={"Authorization": f"Bearer {token}"},
        timeout=5,
    )

    if resp.status_code == 204:
        return jsonify({"authenticated": True, "playing": False})

    if resp.status_code == 200:
        data = resp.json()
        item = data.get("item") or {}
        images = item.get("album", {}).get("images", [])
        return jsonify(
            {
                "authenticated": True,
                "playing": data.get("is_playing", False),
                "track": item.get("name", ""),
                "artist": ", ".join(a["name"] for a in item.get("artists", [])),
                "album": item.get("album", {}).get("name", ""),
                "album_art": images[0]["url"] if images else "",
                "duration_ms": item.get("duration_ms", 0),
                "progress_ms": data.get("progress_ms", 0),
                "volume": (data.get("device") or {}).get("volume_percent", 50),
                "shuffle": data.get("shuffle_state", False),
                "repeat": data.get("repeat_state", "off"),
                "device": (data.get("device") or {}).get("name", ""),
            }
        )

    return jsonify({"authenticated": True, "error": True})


@app.route("/api/spotify/control", methods=["POST"])
def spotify_control():
    token = _spotify_token()
    if not token:
        return jsonify({"error": "Not authenticated"}), 401

    payload = request.get_json() or {}
    action = payload.get("action")
    headers = {"Authorization": f"Bearer {token}"}

    if action == "play":
        requests.put("https://api.spotify.com/v1/me/player/play", headers=headers, timeout=5)
    elif action == "pause":
        requests.put("https://api.spotify.com/v1/me/player/pause", headers=headers, timeout=5)
    elif action == "next":
        requests.post("https://api.spotify.com/v1/me/player/next", headers=headers, timeout=5)
    elif action == "previous":
        requests.post("https://api.spotify.com/v1/me/player/previous", headers=headers, timeout=5)
    elif action == "volume":
        vol = max(0, min(100, int(payload.get("value", 50))))
        requests.put(
            f"https://api.spotify.com/v1/me/player/volume?volume_percent={vol}",
            headers=headers, timeout=5,
        )
    elif action == "shuffle":
        state = str(payload.get("value", False)).lower()
        requests.put(
            f"https://api.spotify.com/v1/me/player/shuffle?state={state}",
            headers=headers, timeout=5,
        )
    elif action == "repeat":
        state = payload.get("value", "off")
        if state not in ("off", "track", "context"):
            return jsonify({"error": "Invalid repeat state"}), 400
        requests.put(
            f"https://api.spotify.com/v1/me/player/repeat?state={state}",
            headers=headers, timeout=5,
        )
    else:
        return jsonify({"error": "Unknown action"}), 400

    return jsonify({"success": True})


# ── Pi-hole ───────────────────────────────────────────────────────────────────

@app.route("/api/pihole/status")
def pihole_status():
    try:
        resp = requests.get(
            f"{PIHOLE_HOST}/admin/api.php?summary&auth={PIHOLE_API_TOKEN}",
            timeout=3,
        )
        if resp.status_code == 200:
            d = resp.json()
            return jsonify(
                {
                    "available": True,
                    "status": d.get("status", "unknown"),
                    "ads_blocked": d.get("ads_blocked_today", 0),
                    "ads_percentage": d.get("ads_percentage_today", 0),
                    "queries_today": d.get("dns_queries_today", 0),
                    "domains_blocked": d.get("domains_being_blocked", 0),
                }
            )
    except Exception:
        pass
    return jsonify({"available": False})


@app.route("/api/pihole/toggle", methods=["POST"])
def pihole_toggle():
    payload = request.get_json() or {}
    action = payload.get("action")
    if action not in ("enable", "disable"):
        return jsonify({"error": "Invalid action"}), 400
    try:
        resp = requests.get(
            f"{PIHOLE_HOST}/admin/api.php?{action}&auth={PIHOLE_API_TOKEN}",
            timeout=5,
        )
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
        resp = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat,
                "longitude": lon,
                "current": "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,apparent_temperature",
                "daily": "temperature_2m_max,temperature_2m_min,weather_code",
                "temperature_unit": "fahrenheit",
                "wind_speed_unit": "mph",
                "timezone": "auto",
                "forecast_days": 5,
            },
            timeout=10,
        )
        if resp.status_code == 200:
            return jsonify({"success": True, "data": resp.json()})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Failed to fetch weather"}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
