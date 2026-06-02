# Iran Drought Monitoring

سامانه پایش خشکسالی ایران با `FastAPI`، `PostGIS`، `Redis` و نقشه تعاملی `Leaflet`.

## امکانات

- نمایش نقشه و پنل آماری برای هر لایه
- پشتیبانی از چند لایه داده مثل station / province / county
- بارگذاری داده فقط یک‌بار و ذخیره در PostGIS
- محاسبه ترندها با Mann-Kendall و Sen's slope
- کش Redis به همراه کش درون‌حافظه‌ای

## پیش‌نیازها

- Docker
- Docker Compose
- Git

## ساختار داده

داده‌ها باید داخل `data/import` قرار بگیرند.

### حالت تک‌لایه

```text
data/import/data.parquet   # اولویت اول
data/import/data.csv       # جایگزین
data/import/geoinfo.geojson
```

این حالت به صورت پیش‌فرض با `dataset_key=station` وارد می‌شود.

### حالت چندلایه

```text
data/import/<dataset_key>/data.parquet
data/import/<dataset_key>/data.csv
data/import/<dataset_key>/geoinfo.geojson
```

`dataset_key` فقط می‌تواند شامل حروف، عدد و `_` باشد.

### قالب CSV

CSV باید یکی از این حالت‌ها را داشته باشد:

- `date`
- `year` + `month`
- `yyyymm`

ستون شناسه می‌تواند یکی از این‌ها باشد:

- `feature_id`
- `station_id`
- `region_id`
- `id`
- `code`
- `gid`
- `fid`
- `name`

بقیه ستون‌ها به عنوان شاخص‌های زمانی ذخیره می‌شوند.

> پوشه `data/user_data` در نسخه فعلی فقط برای سازگاری قدیمی است و در runtime استفاده نمی‌شود.

## اجرای محلی با Docker

### اجرا

```bash
make dev
```

یا:

```bash
docker compose -f docker-compose.dev.yml up --build
```

### آدرس‌ها

- Frontend: `http://localhost:8080`
- Backend health: `http://localhost:8000/health`
- Swagger: `http://localhost:8000/docs`

### توقف

```bash
make dev-down
```

### حذف کامل دیتابیس محلی

```bash
make downv
```

## وارد کردن داده‌ها

ابتدا `data.parquet` (با اولویت) یا `data.csv` به همراه `geoinfo.geojson` را در مسیر درست قرار بده، سپس:

```bash
docker compose -f docker-compose.dev.yml exec backend python /app/import_data.py --replace
```

در سرور:

```bash
make prod-import
```

اگر خواستی مسیر دیگری بدهی:

```bash
python import_data.py --data-dir /path/to/import
```

### نتیجه import

- ایجاد جدول‌های `datasets` و `features`
- ساخت جدول زمانی `ts_<dataset_key>`
- ثبت `min_date` و `max_date`
- پاک‌سازی کش‌ها
- پیش‌محاسبه ترندها

## محاسبه ترند

ترندها به صورت full-history برای هر `feature` و هر `index` محاسبه می‌شوند.

- روش: Mann-Kendall
- شیب: Sen's slope
- ذخیره: جدول `trend_stats`

### اجرای دستی

```bash
docker compose -f docker-compose.dev.yml exec backend python /app/backend/scripts/precompute_trends.py
```

فقط یک لایه:

```bash
docker compose -f docker-compose.dev.yml exec backend python /app/backend/scripts/precompute_trends.py --level station
```

فقط یک شاخص:

```bash
docker compose -f docker-compose.dev.yml exec backend python /app/backend/scripts/precompute_trends.py --level station --index spi3
```

## اجرای روی سرور

### 1) نصب وابستگی‌ها

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx git
sudo systemctl enable --now docker nginx
```

### 2) دریافت پروژه

```bash
cd /opt
sudo git clone https://github.com/HydroCodeIR/IranDroughtMonitoring.git
sudo chown -R "$USER:$USER" IranDroughtMonitoring
cd IranDroughtMonitoring
cp .env.prod.example .env.prod
```

### 3) تنظیم `.env.prod`

مقادیر مهم:

- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `CORS_ORIGINS`

نمونه:

```env
POSTGRES_DB=drought
POSTGRES_USER=drought
POSTGRES_PASSWORD=change-me
DATABASE_URL=postgresql+psycopg2://drought:change-me@db:5432/drought
CORS_ORIGINS=https://drought.werifum.ir,http://drought.werifum.ir
```

### 4) اجرای سرویس‌ها

```bash
make prod-detached
```

### 5) تنظیم Nginx

فایل `deploy/nginx-drought.werifum.ir.conf` را فعال کن:

```bash
sudo cp deploy/nginx-drought.werifum.ir.conf /etc/nginx/sites-available/drought.werifum.ir
sudo ln -s /etc/nginx/sites-available/drought.werifum.ir /etc/nginx/sites-enabled/drought.werifum.ir
```

سپس:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 6) فعال‌سازی SSL

```bash
sudo certbot --nginx -d drought.werifum.ir
```

### 7) بارگذاری داده‌ها

```bash
make prod-import
```

### 8) محاسبه مجدد ترندها

```bash
make prod-precompute-trends
```

## API های اصلی

- `GET /health`
- `GET /datasets`
- `GET /meta?level=<dataset_key>`
- `GET /regions?level=<dataset_key>`
- `GET /mapdata?level=<dataset_key>&index=spi3&date=YYYY-MM&bbox=minLon,minLat,maxLon,maxLat`
- `GET /overview?level=<dataset_key>&index=spi3&date=YYYY-MM`
- `GET /timeseries?region_id=<id>&level=<dataset_key>&index=spi3`
- `GET /kpi?region_id=<id>&level=<dataset_key>&index=spi3&date=YYYY-MM`

## نکته مهم

اگر داده‌ها را تغییر دادی، دوباره `import_data.py --replace` را اجرا کن تا ترندها و کش‌ها با داده جدید هماهنگ شوند.
