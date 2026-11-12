FROM node:20-alpine

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Expose standard application port
EXPOSE 3000

# Run as non-root user for production security
USER node

# Start Sonora audio sync server
CMD ["node", "server.js"]

