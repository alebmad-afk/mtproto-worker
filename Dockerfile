FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy sources
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Install tsx globally for runtime TS execution
RUN npm install -g tsx

# Healthcheck endpoint is optional; worker is long-running
ENV NODE_ENV=production

CMD ["tsx", "src/index.ts"]
