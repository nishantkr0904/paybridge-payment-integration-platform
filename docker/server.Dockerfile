# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root configurations
COPY package.json package-lock.json ./
COPY eslint.config.mjs ./

# Copy workspace package.jsons
COPY server/package.json ./server/
COPY client/package.json ./client/

# Install dependencies (including devDependencies for building)
RUN npm ci

# Copy server source code
COPY server/ ./server/

# Build the server
RUN npm run build --workspace server

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Copy root configurations
COPY package.json package-lock.json ./

# Copy workspace package.jsons
COPY server/package.json ./server/
COPY client/package.json ./client/

# Install only production dependencies
RUN npm ci --omit=dev

# Copy compiled code from builder
COPY --from=builder /app/server/dist ./server/dist

# Copy docs for OpenAPI
COPY docs/ ./docs/

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

# Default command starts the API server
CMD ["npm", "run", "start", "--workspace", "server"]
