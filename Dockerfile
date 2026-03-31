FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock tsconfig.json components.json ./
RUN bun install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
COPY skills ./skills

# Precompile the web UI stylesheet served by the backend.
RUN bun run ui:styles

EXPOSE 3000

CMD ["bun", "run", "apps/backend/server.ts"]
