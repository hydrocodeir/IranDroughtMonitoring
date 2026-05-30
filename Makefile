.PHONY: dev prod prod-detached prod-ps prod-logs prod-restart prod-import prod-precompute-trends prod-down down downv dev-down precompute-trends

PROD_COMPOSE = docker compose --env-file .env.prod -f docker-compose.prod.yml

dev:
	@printf "\nFrontend: http://localhost:8080\n"
	@printf "Backend health: http://localhost:8000/health\n"
	@printf "Note: Docker may show 0.0.0.0:8080; open localhost or 127.0.0.1 in your browser.\n\n"
	docker compose -f docker-compose.dev.yml up --build

prod:
	$(PROD_COMPOSE) up --build

prod-detached:
	$(PROD_COMPOSE) up --build -d

prod-ps:
	$(PROD_COMPOSE) ps

prod-logs:
	$(PROD_COMPOSE) logs -f --tail=100

prod-restart:
	$(PROD_COMPOSE) up --build -d

prod-import:
	$(PROD_COMPOSE) exec backend python /app/import_data.py --replace

prod-precompute-trends:
	$(PROD_COMPOSE) exec backend python /app/backend/scripts/precompute_trends.py

down:
	docker compose down

downv:
	docker compose down -v

dev-down:
	docker compose -f docker-compose.dev.yml down

prod-down:
	$(PROD_COMPOSE) down

precompute-trends:
	docker compose -f docker-compose.dev.yml exec backend python /app/backend/scripts/precompute_trends.py
