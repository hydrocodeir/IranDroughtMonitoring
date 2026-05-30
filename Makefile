.PHONY: dev prod prod-detached precompute-trends

dev:
	@printf "\nFrontend: http://localhost:8080\n"
	@printf "Backend health: http://localhost:8000/health\n"
	@printf "Note: Docker may show 0.0.0.0:8080; open localhost or 127.0.0.1 in your browser.\n\n"
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
