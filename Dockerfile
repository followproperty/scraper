# Use the official Puppeteer pre-configured Node/Chromium environment
FROM ghcr.io/puppeteer/puppeteer:21.5.0

# Set environment to production
ENV NODE_ENV=production

# Set working directory inside the container
WORKDIR /app

# Copy package configurations
COPY package*.json ./

# Install dependencies in clean-install production mode
RUN npm ci --only=production

# Copy all source files
COPY . .

# Build the TypeScript project to JavaScript inside the dist/ folder
RUN npm run build

# Expose Express server port (Render automatically forwards traffic to this port)
EXPOSE 3000

# Start the server
CMD ["node", "dist/index.js"]
