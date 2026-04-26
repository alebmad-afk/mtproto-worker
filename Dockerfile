FROM node:20-alpine

WORKDIR /app

# Install deps from the flat package.json
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy the single worker file (no folders required)
COPY worker.js ./

ENV NODE_ENV=production
CMD ["node", "worker.js"]
