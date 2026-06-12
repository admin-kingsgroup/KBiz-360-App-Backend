# Deploy KBiz360 backend on EC2 (13.127.43.110)

Run these **on the EC2 instance**. (Instance: t3.small / Ubuntu recommended.)

## 1. Open the firewall (AWS Console)
EC2 → Security Groups → inbound rules, add:
- **TCP 4000** from `0.0.0.0/0`  (the API; later 80/443 when you add a domain)
- **TCP 22** from *your IP only* (SSH)

## 2. SSH in
```bash
ssh -i your-key.pem ubuntu@13.127.43.110
```

## 3. Swap (t3.small has 2 GB — gives the Docker build headroom)
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 4. Install Docker + git
```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker
```

## 5. Clone the repo
```bash
git clone https://github.com/admin-kingsgroup/KBiz-360-App-Backend.git
cd KBiz-360-App-Backend
```

## 6. Production env (fill in secrets)
```bash
cp .env.production.example .env.production
nano .env.production      # set MONGODB_URI (rotated), JWT secrets, EMAIL_TOKEN_KEY, MS_*, S3 (or local), etc.
```
Generate secrets quickly:
```bash
node -e "console.log('JWT_ACCESS_SECRET='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('JWT_REFRESH_SECRET='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('EMAIL_TOKEN_KEY='+require('crypto').randomBytes(32).toString('hex'))"
```
(Optional) Firebase key for the native call screen:
```bash
mkdir -p secrets && nano secrets/firebase.json   # paste the service-account JSON
# then uncomment the firebase volume line in docker-compose.prod.yml + set FIREBASE_SERVICE_ACCOUNT
```

## 7. MongoDB Atlas → allow this server
Atlas → Network Access → add IP `13.127.43.110/32`.

## 8. Build & run
```bash
docker compose -f docker-compose.prod.yml up -d --build
docker logs -f kb360        # watch startup; Ctrl-C to stop watching
curl localhost:4000/health  # {"status":"ok",...}
```
From your laptop: `curl http://13.127.43.110:4000/health` should now work.

## 9. Updates later
```bash
cd ~/KBiz-360-App-Backend && git pull && docker compose -f docker-compose.prod.yml up -d --build
```
(Or enable the SSH auto-deploy job in `.github/workflows/ci.yml` with repo secrets EC2_HOST/EC2_USER/EC2_SSH_KEY.)

---

## Going HTTPS (do this before real production)
Plain HTTP sends login tokens/email in the clear, and **iOS release builds + Android require HTTPS**.
1. Point a domain (e.g. `api.kbiz360.com`) → A record → `13.127.43.110`.
2. Open SG ports **80** and **443**.
3. Create `Caddyfile`:
   ```
   api.kbiz360.com {
       reverse_proxy backend:4000
   }
   ```
4. In `docker-compose.prod.yml`: uncomment the `caddy` service + volumes, and **remove** the
   backend's `ports: ["4000:4000"]` (Caddy fronts it). `docker compose -f docker-compose.prod.yml up -d`.
5. Update the app's `apiUrl` to `https://api.kbiz360.com`.

## TURN (calls across mobile networks) — optional
```bash
sudo apt install -y coturn
# /etc/turnserver.conf:  realm=kbiz360 ; listening-port=3478 ; lt-cred-mech ; user=kb360:<strongpass> ; external-ip=13.127.43.110
sudo systemctl enable --now coturn
# SG: open UDP 3478 + UDP 49152-65535. Then set TURN_URL/USERNAME/PASSWORD in .env.production.
```
