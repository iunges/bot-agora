FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
