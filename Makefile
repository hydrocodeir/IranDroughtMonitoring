.PHONY: dev prod precompute-trends

dev:
	docker compose -f docker-compose.dev.yml up --build

prod:
	docker compose -f docker-compose.yml up --build

down:
	docker compose down

downv:
	docker compose down -v

dev-down:
	docker compose -f docker-compose.dev.yml down

prod-down:
	docker compose -f docker-compose.yml down
precompute-trends:
	docker compose -f docker-compose.dev.yml exec backend python /app/backend/scripts/precompute_trends.py
