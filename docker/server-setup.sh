#!/bin/bash
# Prepares a new Ubuntu 24.04 server for Tally (T4.3, D60). Run once as root; safe to run again.
#   scp docker/server-setup.sh docker/set-secrets.sh docker/db-owner.sh root@<server>:/root/
#   ssh root@<server> bash /root/server-setup.sh '<the deploy public key>'
# Installs Docker (from Docker's own package list) and automatic security updates, allows only
# SSH, HTTP and HTTPS in, adds 2 GB of swap, turns off password logins, and creates the `deploy`
# user that GitHub Actions uses. That user can run Docker, which on this server equals root (D60).
set -euo pipefail
deploy_key=${1:?Usage: server-setup.sh '<deploy public key>'}

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl ufw unattended-upgrades
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
dpkg-reconfigure -f noninteractive unattended-upgrades
# Security updates restart the server when they need to, at 02:00 UTC (04:00 or 05:00 in Israel):
# after the nightly month check at 03:00 Israel time, before anyone works.
cat > /etc/apt/apt.conf.d/52tally-upgrades <<UPGRADES
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "02:00";
UPGRADES

ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Keys only. A file named 00-… is read first, so it wins over the cloud image's own settings.
# Root keeps its key access (and the provider's web console works without SSH).
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' > /etc/ssh/sshd_config.d/00-tally.conf
sshd -t && systemctl reload ssh
sshd -T | grep -qx 'passwordauthentication no' || { echo "SSH still allows passwords"; exit 1; }
sshd -T | grep -qx 'kbdinteractiveauthentication no' || { echo "SSH still allows keyboard logins"; exit 1; }

id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash -G docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# restrict: no port, agent or X11 forwarding for this key.
echo "restrict $deploy_key" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

install -d -m 700 -o deploy -g deploy /opt/tally
for script in set-secrets.sh db-owner.sh; do
  install -m 700 -o deploy -g deploy "$(dirname "$0")/$script" "/opt/tally/$script"
done
[ -f /opt/tally/.env ] || install -m 600 -o deploy -g deploy /dev/null /opt/tally/.env
echo "Server ready. Next: the settings (/opt/tally/.env) and the database certificate (/opt/tally/db-ca.pem)."
