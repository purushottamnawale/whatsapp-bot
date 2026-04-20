#!/bin/bash

source .env
# Connect and execute
ssh -i "$WA_SERVER_PRIVATE_KEY_PATH" "$WA_SERVER_HOST" \
    "DEPLOY_PATH='$DEPLOY_PATH' GITHUB_TOKEN='$GITHUB_TOKEN' bash -s" << 'EOF'
    echo "Successfully connected to $(hostname)"
    echo "The uptime is: $(uptime)"

    # Standard maintenance
    sudo snap refresh
    sudo apt update -y
    sudo apt upgrade -y
    sudo apt autoremove -y
    sudo apt clean

    # Check if chromium is already installed
    if command -v chromium &> /dev/null; then
        echo "Chromium is already installed. Skipping..."
    else
        echo "Chromium not found. Installing now..."
        sudo add-apt-repository ppa:xtradeb/apps -y
        sudo apt update
        sudo apt install chromium -y
    fi

    if command -v git &> /dev/null; then
        echo "git is already installed. Skipping..."
    else
        echo "git not found. Installing now..."
        sudo apt-get update
        sudo apt-get install git -y
    fi


    # Check if the directory exists, if not, create it
    mkdir -p "$DEPLOY_PATH"

    if [ -d "$DEPLOY_PATH/.git" ]; then
        echo "Valid Git repository found. Updating code..."
    else
        echo "Cloning repository..."
        git clone "https://purushottamnawale:${GITHUB_TOKEN}@github.com/purushottamnawale/whatsapp-bot.git" "$DEPLOY_PATH"
    fi
    cd "$DEPLOY_PATH" || exit
    git pull origin main

    npm install

    (crontab -l 2>/dev/null | grep -v "/home/ubuntu/falcon-whatsapp-bot"; echo "0 8 * * * cd /home/ubuntu/falcon-whatsapp-bot && /usr/bin/npm run send >> /home/ubuntu/falcon-whatsapp-bot/cron.log 2>&1") | crontab -
    crontab -l
EOF

# Copy the .env file to the server
scp -i "$WA_SERVER_PRIVATE_KEY_PATH" ".env" "$WA_SERVER_HOST:$DEPLOY_PATH/.env" 