# راه اندازی داشبورد روی VPS برای drought.werifum.ir

این راهنما فرض می کند Nginx روی خود VPS نقش reverse proxy را دارد و کانتینر frontend فقط روی `127.0.0.1:8080` گوش می دهد.

## 1. DNS

در پنل DNS دامنه، رکورد زیر را بسازید:

```text
A  drought  <VPS_PUBLIC_IP>
```

بعد از اعمال DNS، روی VPS بررسی کنید:

```bash
dig +short drought.werifum.ir
```

خروجی باید IP همان VPS باشد.

## 2. نصب پکیج های لازم روی Ubuntu

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx git dnsutils
sudo systemctl enable --now docker nginx
sudo usermod -aG docker "$USER"
```

بعد از `usermod` یک بار از SSH خارج شوید و دوباره وارد شوید.

اگر از `ufw` استفاده می کنید:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## 3. دریافت پروژه

```bash
cd /opt
sudo git clone https://github.com/HydroCodeIR/IranDroughtMonitoring.git
sudo chown -R "$USER:$USER" IranDroughtMonitoring
cd IranDroughtMonitoring
```

اگر پروژه را از قبل روی VPS دارید، فقط وارد همان پوشه شوید و آخرین تغییرات را بگیرید:

```bash
git pull
```

## 4. ساخت فایل محیط production

```bash
cp .env.prod.example .env.prod
openssl rand -hex 32
nano .env.prod
```

مقدار تولیدشده توسط `openssl` را به عنوان `POSTGRES_PASSWORD` بگذارید و همان مقدار را در `DATABASE_URL` هم جایگزین کنید.

نمونه:

```env
POSTGRES_DB=drought
POSTGRES_USER=drought_user
POSTGRES_PASSWORD=<strong-random-password>
DATABASE_URL=postgresql+psycopg2://drought_user:<strong-random-password>@db:5432/drought
CORS_ORIGINS=https://drought.werifum.ir,http://drought.werifum.ir
FRONTEND_PORT=8080
```

اگر پسورد شامل کاراکترهای خاص URL مثل `@`, `:`, `/`, `#` باشد، یا آن را URL-encode کنید یا از پسورد hex بالا استفاده کنید.

## 5. بالا آوردن کانتینرها

```bash
make prod-detached
make prod-ps
```

در خروجی باید frontend روی `127.0.0.1:8080->80/tcp` دیده شود.

## 6. import داده ها

```bash
make prod-import
make prod-precompute-trends
```

اگر فقط می خواهید سرویس را سریع تست کنید، اول `make prod-import` کافی است.

## 7. نصب reverse proxy در Nginx

```bash
sudo cp deploy/nginx-drought.werifum.ir.conf /etc/nginx/sites-available/drought.werifum.ir
sudo ln -sfn /etc/nginx/sites-available/drought.werifum.ir /etc/nginx/sites-enabled/drought.werifum.ir
sudo nginx -t
sudo systemctl reload nginx
```

اگر سایت default مزاحم بود:

```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

## 8. فعال کردن HTTPS

```bash
sudo certbot --nginx -d drought.werifum.ir
```

گزینه redirect به HTTPS را انتخاب کنید.

## 9. تست نهایی

```bash
curl -I http://127.0.0.1:8080
curl -I http://drought.werifum.ir
curl -I https://drought.werifum.ir
```

سپس در مرورگر باز کنید:

```text
https://drought.werifum.ir
```

## دستورهای مفید

```bash
make prod-logs
make prod-ps
make prod-restart
make prod-down
```

لاگ مستقیم یک سرویس:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f backend
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f frontend
```
