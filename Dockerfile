# Use the official Puppeteer pre-configured Node/Chromium environment
FROM ghcr.io/puppeteer/puppeteer:21.5.0

# Set working directory inside the container
WORKDIR /app

# Copy package configurations
COPY package*.json ./

# Install all dependencies (dev dependencies are required for typescript compilation)
RUN npm ci

# Copy all source files
COPY . .

# Build the TypeScript project to JavaScript inside the dist/ folder
RUN npm run build

# Set environment to production after compilation is complete
ENV NODE_ENV=production

# Expose Express server port (Render automatically forwards traffic to this port)
EXPOSE 3000

# Start the server
CMD ["node", "dist/index.js"]
