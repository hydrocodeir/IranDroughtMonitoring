.PHONY: dev prod prod-detached precompute-trends

dev:
	docker compose -f docker-compose.dev.yml up --build

prod:
	docker compose --env-file .env.prod -f docker-compose.prod.yml up --build

prod-detached:
	docker compose --env-file .env.prod -f docker-compose.prod.yml up --build -d

down:
	docker compose down

downv:
	docker compose down -v

dev-down:
	docker compose -f docker-compose.dev.yml down

prod-down:
	docker compose --env-file .env.prod -f docker-compose.prod.yml down
precompute-trends:
	docker compose -f docker-compose.dev.yml exec backend python /app/backend/scripts/precompute_trends.py
