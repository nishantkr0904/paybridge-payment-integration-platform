# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root configurations
COPY package.json package-lock.json ./
COPY eslint.config.mjs ./

# Copy workspace package.jsons
COPY server/package.json ./server/
COPY client/package.json ./client/

# Install all dependencies
RUN npm ci

# Copy client source code
COPY client/ ./client/

# Build the Vite application
RUN npm run build --workspace client

# Stage 2: Serve
FROM nginx:alpine

# Copy built assets to NGINX
COPY --from=builder /app/client/dist /usr/share/nginx/html

# Expose port 80
EXPOSE 80

# Configure NGINX to handle React Router navigation
RUN echo 'server { \
    listen 80; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html index.htm; \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

CMD ["nginx", "-g", "daemon off;"]
