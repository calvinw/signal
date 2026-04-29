# Production Dockerfile for Signal with MCP Integration
# Multi-stage build to optimize image size and security

# Stage 1: Build stage
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Install build dependencies (needed for native modules)
RUN apk add --no-cache python3 make g++

# Copy package files (all workspace package.json files needed for npm ci)
COPY package.json package-lock.json turbo.json ./
COPY app/package.json ./app/
COPY packages/api/package.json ./packages/api/
COPY packages/community/package.json ./packages/community/
COPY packages/core/package.json ./packages/core/
COPY packages/dialog-hooks/package.json ./packages/dialog-hooks/
COPY packages/firebaseui-web-react/package.json ./packages/firebaseui-web-react/
COPY packages/player/package.json ./packages/player/

# Install dependencies
RUN npm ci

# Copy source code
COPY app/ ./app/
COPY packages/ ./packages/

# Build for production
RUN npm run build:app

# Stage 2: Production stage
FROM python:3.11-slim AS production

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy Python requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist

# Copy Python server files
COPY mcp-server/signal_mcp_server.py .

# Expose port
EXPOSE 8080

# Set environment to production
ENV NODE_ENV=production

# Run the FastAPI server
CMD ["python", "signal_mcp_server.py"]
