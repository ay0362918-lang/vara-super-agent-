FROM node:20

RUN apt-get update && apt-get install -y git

WORKDIR /app

COPY . .

RUN npm install -g vara-wallet
RUN npx skills add gear-foundation/vara-skills -g --all
RUN npx skills add Adityaakr/polybaskets -g --all

RUN npm install

# 👇 FORCE LOG SO WE KNOW IT STARTS
CMD echo "🔥 STARTING BOT..." && node index.js
