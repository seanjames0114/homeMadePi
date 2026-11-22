#!/usr/bin/env bash
set -e

echo "==> HomeMade Pi Setup"

pip3 install -r requirements.txt

if [ ! -f .env ]; then
    cp .env.example .env
    SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    sed -i "s/change-me-to-a-random-secret/$SECRET/" .env
    echo "==> Created .env — add your Spotify credentials to enable music control"
else
    echo "==> .env already exists"
fi

if [ "$1" = "--service" ]; then
    WORKDIR=$(pwd)
    PYTHON=$(which python3)
    sudo tee /etc/systemd/system/homemadepi.service > /dev/null <<EOF
[Unit]
Description=HomeMade Pi Home Assistant
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$WORKDIR
ExecStart=$PYTHON app.py
Restart=always
RestartSec=5
EnvironmentFile=$WORKDIR/.env

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable homemadepi
    sudo systemctl start homemadepi
    echo "==> Service started — sudo systemctl status homemadepi"
else
    echo ""
    echo "  Run:            python3 app.py"
    echo "  Auto-start:     bash setup.sh --service"
    echo "  Access at:      http://$(hostname -I | awk '{print $1}' 2>/dev/null || echo 'your-pi-ip'):5000"
fi
