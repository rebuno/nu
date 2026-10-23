NU_HOME ?= $(HOME)/.nu

.PHONY: dev client lint format typecheck

dev:
	mkdir -p "$(NU_HOME)/workspace" "$(NU_HOME)/sandbox" "$(NU_HOME)/skills" "$(NU_HOME)/packages"
	docker compose up -d --build

client:
	pnpm build:client
	npm install -g ./dist/client

lint:
	pnpm lint

format:
	pnpm format

typecheck:
	pnpm typecheck
